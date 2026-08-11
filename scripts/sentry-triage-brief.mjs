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
 * The rendering, the two markdown escapes and the inert-block assertion live in
 * scripts/sentry-triage-brief-render.mjs (#1769 round 9 file-size split) and are
 * re-exported below; their security posture is documented there. This module
 * owns the lifecycle, the GitHub I/O, and the write-side terminal guards
 * (#1769 rounds 6-7). The brief comment is DISPLAY-ONLY: no pipeline consumer
 * parses it as a contract, so this leg selects the comment to update/delete by
 * the shared trusted-author + marker fence (`isTrustedComment` +
 * `BRIEF_COMMENT_MARKER`), and a drive-by commenter cannot make it PATCH or
 * DELETE their comment.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO,
  extractPermalink,
  isTrustedComment,
  parseShortId,
  resolveVerdict,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";
// The terminal marker the write-side guard refuses to write past — one source of
// truth with the archive leg that applies it.
import { ARCHIVED_LABEL } from "./sentry-triage-queue-contract.mjs";
// Pure rendering + the two markdown escapes + the inert-block assertion live in
// a sibling module (#1769 round 9 file-size split). Re-exported here so the brief
// leg stays one import surface for its consumers (its tests, the archive leg).
import {
  assertInertBlock,
  BRIEF_COMMENT_MARKER,
  renderBriefComment,
} from "./sentry-triage-brief-render.mjs";

export {
  assertInertBlock,
  BRIEF_COMMENT_MARKER,
  escapeGithubLinkDestination,
  escapeGithubMarkdown,
  renderBriefComment,
} from "./sentry-triage-brief-render.mjs";

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

/** A `gh` failure whose target no longer exists (HTTP 404). Local copy of the
 * archive leg's predicate — brief.mjs cannot import from archive.mjs, which
 * imports IT (round 5). Used to treat "the archive already deleted this brief"
 * as a no-op success rather than a failure. */
function isNotFoundError(err) {
  return /HTTP 404|Not Found/i.test(err instanceof Error ? err.message : "");
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
    try {
      await deleteBriefComment(runGh, repo, briefCommentId(comment));
      removed += 1;
    } catch (err) {
      // A 404 means the comment is ALREADY gone — the clear's whole goal — so a
      // concurrent delete is SUCCESS, not a failure. Without this, the projection
      // leg marks the row failed and re-queues, and the archive leg logs a
      // misleading "stale brief could not be cleared" warning, for a stub whose
      // brief is already gone (#1769 round 13). Same 404-as-success rule the
      // verdict-change clear path already applies; any other error still throws.
      if (!isNotFoundError(err)) throw err;
    }
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
 * brief comment with no parseable id. The workflow step is best-effort (#1769
 * round 8): a failure here logs and the job continues, leaving the stub in its
 * already-correct post-verdict state. Everything this leg does is idempotent.
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
      try {
        await deleteBriefComment(runGh, repo, briefCommentId(comment));
        written = true;
      } catch (err) {
        // A 404 means the comment is ALREADY gone — the clear's whole goal — so
        // a concurrent delete is success, not a failure. Any other error is a
        // real clear failure and must surface: the workflow step fails on it to
        // BLOCK the close, so the stub is never closed still showing the stale
        // brief (#1769 round 10). The clear is NOT best-effort like the render.
        if (!isNotFoundError(err)) throw err;
      }
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
    try {
      await updateBriefComment(runGh, repo, briefCommentId(primary), block);
      written = true;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      // The target comment is gone between our read and this PATCH. Only accept
      // that as SETTLED when the stub is actually terminal — the archive leg
      // deleting the brief on settlement (#1769 round 7). Re-read the terminal
      // signals to tell that apart from a maintainer/other actor deleting the
      // brief on an OPEN, unarchived stub: assuming settlement there would leave
      // a live needs-human stub with no decision-ready comment and no retry, so
      // CREATE it fresh instead (#1769 round 10). The post-write settlement
      // below still runs, so a recreate that itself goes terminal self-heals.
      const state = await readStubTerminalState(runGh, repo, issueNumber);
      if (state.closed || state.archived) {
        log(
          `::notice::Issue #${issueNumber}: the brief comment was already deleted and the stub is terminal (state=${state.state}, archived=${state.archived}); treating as a no-op.`,
        );
        return { written: false, verdict, settledTerminal: true };
      }
      log(
        `::notice::Issue #${issueNumber}: the brief comment was deleted on an open stub; recreating it.`,
      );
      await createBriefComment(runGh, repo, issueNumber, block);
      written = true;
    }
  }
  // Never leave two "Decision needed" comments on one stub.
  for (const duplicate of duplicates) {
    await deleteBriefComment(runGh, repo, briefCommentId(duplicate));
    written = true;
  }

  // Post-write settlement (#1769 round 7). The pre-write guard is a TOCTOU
  // check: an archive can close+archive the stub AND run its own cleanup in the
  // window between that read and this write, after which the comment we just
  // created/updated sits on a closed archive. Re-read the terminal state AFTER
  // the write and, if the stub is now terminal, delete the brief we just wrote.
  // The common race self-heals within the run — the write-side complement of
  // the archive's cleanup (round 5) and the pre-write guard (round 6), closing
  // the last window. Idempotent, and it removes only marked comments.
  if (written) {
    const settled = await readStubTerminalState(runGh, repo, issueNumber);
    if (settled.closed || settled.archived) {
      const { comments } = await readQueueIssue(runGh, repo, issueNumber);
      await clearBriefComments({ runGh, repo, issueNumber, comments, log });
      log(
        `::notice::Issue #${issueNumber} settled terminal during the brief write; removed the brief just written (state=${settled.state}, archived=${settled.archived}).`,
      );
      return { written: false, verdict, settledTerminal: true };
    }
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
