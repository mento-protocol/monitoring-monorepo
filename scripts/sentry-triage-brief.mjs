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
 *     (`selectNeedsHumanBriefFields`, `MAX_BRIEF_TEXT_LEN`), then
 *     `neutralizeUntrusted` — control chars stripped, newlines collapsed,
 *     backticks defanged, `@` defanged, `<!--` broken — and finally this
 *     emitter's own surface escape, `escapeGithubMarkdown`. The escape is what
 *     makes the omission policy hold on the RENDERED surface too: the brief
 *     shows the verdict's fields and the pipeline's own controls, and nothing
 *     an agent wrote may render as a control of its own. Neutralization alone
 *     leaves `[text](url)`, `![img](url)`, raw HTML and entity references
 *     active, which is enough for agent text to put a clickable link beside the
 *     trusted `[View in Sentry]` one.
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
 * THE BLOCK'S LIFECYCLE, in one place, because a rendering that outlives what it
 * renders is worse than no rendering: a stale "Decision needed" block is read as
 * current by whoever opens the issue. The block exists IFF a live needs-human
 * verdict describes the stub.
 *   - needs-human verdict -> render, replacing any previous block (idempotent,
 *     so a re-triage never stacks a second one).
 *   - ANY other verdict -> REMOVE the block. The workflow step is therefore
 *     ungated: gating it on needs-human is what let a brief survive a re-triage
 *     to code-fix / config-fix / upstream-transient permanently.
 *   - a re-queue would be the earliest moment to drop a fenced verdict's
 *     rendering, and this leg deliberately does not reach there: the re-queue
 *     chokepoint writes no stub body at all (issue #1692, pinned by a test in
 *     sentry-triage-requeue.test.mjs). So a re-queued stub carries its old block
 *     until the next round's verdict lands, on a stub whose labels already read
 *     `sentry:needs-triage`.
 *
 * THE WRITE IS NOT ALONE ON THIS BODY. The archive leg rewrites the same body to
 * record its freshness baseline, under a DIFFERENT concurrency group, so the two
 * can overlap on one stub — and `gh issue edit` replaces the WHOLE body, with no
 * conditional update to make the replace safe. Losing that baseline is silent
 * and it strands the archive contract (issue #1371), so:
 *   - THE BRIEF YIELDS. A stub carrying `sentry:approved-archive` or
 *     `sentry:archived` belongs to the archive leg, and this leg does not write
 *     to it at all (`archiveHoldsStub`, re-checked every round). The writer with
 *     nothing at stake gives way: an approved stub is on its way to closed, and
 *     the next triage round renders the block if it survives.
 *   - Inside the remaining window — an archive that starts after this leg's read
 *     and takes the stub's labels with it — the write still builds from a live
 *     read, refuses to move the baseline itself (`assertBaselineUnchanged`),
 *     re-reads afterwards, and restores a baseline it can see was lost.
 *   - The one interleaving a whole-body replace cannot detect from the body
 *     alone — the FIRST archive of a stub, where before and after both read as
 *     "no baseline" — is caught by the archive's own labels appearing on the
 *     post-write read, and fails the job RED. A value this leg never saw is not
 *     one it may invent.
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
// The block's delimiters and its removal live in the queue contract, because the
// re-queue chokepoint removes the block too and the two must agree byte for byte.
import {
  APPROVED_ARCHIVE_LABEL,
  ARCHIVED_LABEL,
  BRIEF_BLOCK_END,
  BRIEF_BLOCK_START,
  parseArchiveBaseline,
  stripBriefFromBody,
  withArchiveBaseline,
} from "./sentry-triage-queue-contract.mjs";

// The stub body's own first line, owned by the ingest (`BODY_MARKER` there).
// The brief goes AFTER it and BEFORE the metadata yaml block: the marker stays
// the body's first line, which is how every stub written since queue contract
// v2 looks, and the yaml block keeps its position relative to the readers that
// find it by fence rather than by offset.
export const STUB_BODY_MARKER = "<!-- sentry-triage:v1 -->";

export { BRIEF_BLOCK_END, BRIEF_BLOCK_START, stripBriefFromBody };

// How many read -> write -> verify rounds the body write takes before it gives
// up and fails the job. Two is enough for one interfering write; the third is
// there so a repair round still gets a verification of its own.
export const BRIEF_WRITE_ATTEMPTS = 3;

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
 * Neutralization makes a field single-line and kills backticks, mentions and
 * comment openers; it does NOT stop the field from RENDERING. A question
 * carrying `[View in Sentry](https://evil.example)` or a step carrying
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

export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

/**
 * Is the archive leg holding this stub? `sentry:approved-archive` means a human
 * approved it and the archive workflow is triggered, queued or running;
 * `sentry:archived` means it already settled, and the stub is closed with its
 * freshness baseline live in the body. Either way this leg does not write.
 *
 * This is the coordination between the two body writers. They hold different
 * concurrency groups, `gh issue edit` replaces the whole body, and GitHub has
 * no conditional issue update — so the writer with nothing at stake yields.
 * Nothing is lost by yielding: an approved stub is on its way to closed, and
 * the next triage round renders the block if it survives.
 */
export function archiveHoldsStub(labels) {
  const names = labelNames(labels);
  return (
    names.includes(APPROVED_ARCHIVE_LABEL) || names.includes(ARCHIVED_LABEL)
  );
}

/** Body + labels: the write loop re-reads once per round, and needs the labels
 * to see the archive leg. The comments are the largest part of a stub and the
 * verdict is resolved once, from the full read below, never re-resolved
 * mid-write. */
async function readStubState(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "body,labels",
  ]);
  const data = JSON.parse(stdout);
  return { body: data.body ?? "", labels: labelNames(data.labels) };
}

async function readQueueIssue(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    labels: labelNames(data.labels),
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    comments: data.comments ?? [],
  };
}

/** Same baseline, field for field. A null on both sides counts as same: a stub
 * that has never been archived carries none, and that is not a loss. */
function sameBaseline(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.lastSeen === b.lastSeen && a.sentryIssueId === b.sentryIssueId;
}

/**
 * Fail CLOSED if THIS leg's own edit would move the archive freshness baseline.
 * Nothing in the render or the removal touches the yaml block, so a difference
 * means the body transform changed shape — and the field it would take with it
 * is the one whose placement in the body IS a trust boundary (issue #1371;
 * losing it silently reverts every later regression of that Sentry issue to the
 * `closedAt` comparison the baseline exists to replace).
 */
export function assertBaselineUnchanged(previousBody, nextBody, issueNumber) {
  const before = parseArchiveBaseline(previousBody);
  const after = parseArchiveBaseline(nextBody);
  if (!sameBaseline(before, after)) {
    throw new Error(
      `Refusing to write issue #${issueNumber}: the brief edit would change the archive freshness baseline (${
        before ? before.lastSeen : "absent"
      } -> ${after ? after.lastSeen : "absent"}).`,
    );
  }
  return nextBody;
}

/**
 * Apply `mutate` to the stub body and make it STICK, against a concurrent
 * archive run rewriting the same body under a different concurrency group.
 *
 * Every round reads the body live and rebuilds from THAT, never from an earlier
 * snapshot — writing back a stale snapshot is precisely how one writer deletes
 * the other's edit. After the write it reads again and asks two questions:
 * is `mutate` now a fixed point on the live body (our edit is present and
 * current), and did the archive baseline survive? A lost baseline is restored
 * from the pre-write read before the next round, so an interleaving cannot cost
 * the body either mutation.
 *
 * `mutate` must be idempotent — both callers are (an applied block replaces
 * itself; a removed block stays removed) — because the fixed-point test is what
 * stands in for the compare-and-set GitHub does not offer on issue bodies.
 */
async function settleStubBody({
  runGh,
  repo,
  issueNumber,
  first, // `{ body, labels }` from the read that resolved the verdict
  mutate,
  dryRun,
  log,
}) {
  let live = first;
  let wrote = false;
  for (let attempt = 1; attempt <= BRIEF_WRITE_ATTEMPTS; attempt += 1) {
    // YIELD, don't race. Checked every round, on a body read this loop takes
    // anyway, so an approval that lands mid-loop still stops the next write.
    if (archiveHoldsStub(live.labels)) {
      log(
        `::notice::Issue #${issueNumber} is held by the archive leg (${APPROVED_ARCHIVE_LABEL} / ${ARCHIVED_LABEL}); leaving its body alone so the freshness baseline cannot be replaced. The next triage round renders the brief if the stub is still open.`,
      );
      return { written: wrote, body: live.body, yielded: true };
    }

    const next = mutate(live.body);
    if (next === null) {
      throw new Error(
        `Issue #${issueNumber} carries a brief opener with no closing delimiter; refusing to rewrite the body. Repair the body by hand and re-run.`,
      );
    }
    if (next === live.body) return { written: wrote, body: next };
    assertBaselineUnchanged(live.body, next, issueNumber);
    if (dryRun) {
      log(next);
      return { written: false, body: next };
    }

    // `--body-file -` reads the body from stdin: the body carries untrusted
    // agent prose and must never transit an argv slot or a shell.
    await runGh(
      ["issue", "edit", String(issueNumber), "-R", repo, "--body-file", "-"],
      { stdin: next },
    );
    wrote = true;

    const after = await readStubState(runGh, repo, issueNumber);
    const stuck = mutate(after.body) === after.body;
    const baselineBefore = parseArchiveBaseline(live.body);
    const baselineAfter = parseArchiveBaseline(after.body);

    // The archive started AND settled inside this write's window: the stub now
    // shows the archive's labels, and the body this write left behind carries
    // no baseline. When the pre-write read had one, restore it. When it did not
    // — the first archive of this stub, the case a whole-body replace cannot
    // detect from the body alone — the value is not ours to invent, so fail
    // RED rather than leave the archive contract stranded on `closedAt`.
    if (!baselineAfter && archiveHoldsStub(after.labels)) {
      if (!baselineBefore) {
        throw new Error(
          `Issue #${issueNumber}: an archive run landed inside this brief write's window — the stub now carries the archive labels and its body has no freshness baseline, which this write replaced. Re-run the archive workflow for this stub so the baseline is recorded again.`,
        );
      }
      const repaired = withArchiveBaseline(after.body, baselineBefore);
      if (repaired === null) {
        throw new Error(
          `Issue #${issueNumber} lost its archive freshness baseline to a concurrent write and has no yaml block to restore it into; repair the body by hand.`,
        );
      }
      log(
        `::notice::Restoring the archive freshness baseline on issue #${issueNumber}; a concurrent body write dropped it (round ${attempt}).`,
      );
      await runGh(
        ["issue", "edit", String(issueNumber), "-R", repo, "--body-file", "-"],
        { stdin: repaired },
      );
      live = await readStubState(runGh, repo, issueNumber);
      continue;
    }

    const lostBaseline = Boolean(baselineBefore) && !baselineAfter;
    if (stuck && !lostBaseline) return { written: true, body: after.body };

    if (lostBaseline) {
      const repaired = withArchiveBaseline(after.body, baselineBefore);
      if (repaired === null) {
        throw new Error(
          `Issue #${issueNumber} lost its archive freshness baseline to a concurrent write and has no yaml block to restore it into; repair the body by hand.`,
        );
      }
      log(
        `::notice::Restoring the archive freshness baseline on issue #${issueNumber}; a concurrent body write dropped it (round ${attempt}).`,
      );
      await runGh(
        ["issue", "edit", String(issueNumber), "-R", repo, "--body-file", "-"],
        { stdin: repaired },
      );
    }
    live = await readStubState(runGh, repo, issueNumber);
  }
  throw new Error(
    `Issue #${issueNumber}: the brief write did not settle after ${BRIEF_WRITE_ATTEMPTS} rounds — another writer keeps replacing the body. Re-run once the archive workflow for this stub has finished.`,
  );
}

/**
 * Read the stub, resolve its verdict, and drive the brief block to the state
 * that verdict implies: rendered for `needs-human`, REMOVED for every other
 * verdict. The removal arm is why the workflow step is ungated — a brief that
 * survives a re-triage to code-fix describes a decision nobody has to make any
 * more, and it sits at the top of the issue looking current.
 *
 * Fails LOUD on a missing/stale/invalid verdict (via `resolveVerdict`), on a
 * malformed existing block, and on a write that cannot be made to stick. The
 * verdict job runs this after the label swap, inside the window where
 * `sentry:needs-triage` is already off, so its step catches a failure here and
 * re-queues the stub before failing — see the compensation in
 * .github/workflows/sentry-triage-agent.yml. Everything this leg does is
 * idempotent, so that retry costs nothing.
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

  let mutate;
  if (verdict === "needs-human") {
    const block = assertInertBlock(
      renderBriefBlock({
        parsed,
        shortId: parseShortId(issue.title),
        permalink: extractPermalink(issue.body),
      }),
    );
    mutate = (body) => applyBriefToBody(body, block);
  } else {
    mutate = stripBriefFromBody;
  }

  const { written, body, yielded } = await settleStubBody({
    runGh,
    repo,
    issueNumber,
    first: { body: issue.body, labels: issue.labels },
    mutate,
    dryRun,
    log,
  });
  if (written) {
    log(
      verdict === "needs-human"
        ? `Wrote the needs-human brief to issue #${issueNumber}.`
        : `Removed the stale needs-human brief from issue #${issueNumber} (verdict is ${verdict}).`,
    );
  } else if (!dryRun && !yielded) {
    // A yield already said why on its own line; do not follow it with a claim
    // about the block's state that this run deliberately did not establish.
    log(
      `Issue #${issueNumber} already carries the brief its ${verdict} verdict implies; nothing to write.`,
    );
  }
  return { written, verdict, body, yielded: Boolean(yielded) };
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
