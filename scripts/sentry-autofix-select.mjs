#!/usr/bin/env node
/**
 * Selection leg of the Sentry AUTOFIX pipeline (ADR 0036 Stage C, Phase 2b —
 * docs/notes/sentry-triage-pipeline.md "Autofix PRs (Phase 2b)"). A
 * deterministic, no-LLM step that picks the queue stubs a scoped fix PR should
 * be attempted for, so the fix job's matrix is built from validated,
 * closed-enum inputs only — never from anything an LLM produced.
 *
 * It reads queue issues labeled `sentry:verdict-code-fix` (auto-closed on
 * verdict, so `--state all`), re-parses each stub's verdict through the SAME
 * authoritative parser the triage label step uses
 * (`scripts/sentry-triage-project-core.mjs` `resolveVerdict`), and keeps only
 * the ones whose `affected_repo` is EXACTLY this repo
 * (`mento-protocol/monitoring-monorepo`) — an external or unrecognized owning
 * repo is never fixed here. Selection is bounded and idempotent:
 *
 *   - DEDUP: a stub already carrying `sentry:fix-pr-opened` (a PR was opened) or
 *     `sentry:fix-refused` (an attempt declined to open one), or whose SHORT-ID
 *     is quoted-referenced by an OPEN PR, is skipped — the autofix leg never
 *     opens a second PR for the same Sentry issue, and never re-burns the cap on
 *     an unfixable stub. A merged/closed PR does NOT block: once a fixed issue
 *     regresses (ingest sheds the autofix markers on reopen), the stub is
 *     re-attemptable by design.
 *   - Oldest-first, hard-capped at `--cap` (default 2) per run (quota cap).
 *
 * Pure of the kill switch / secret guards — the workflow's select job runs
 * those in bash and only invokes this script when the pipeline is enabled and
 * provisioned. Prints a JSON array of `{ issue, shortId }` matrix entries to
 * stdout (diagnostics on stderr).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO,
  isValidShortId,
  parseShortId,
  resolveVerdict,
  selectVerdictComment,
  validateAffectedRepo,
} from "./sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  PROJECTED_LABEL,
} from "./sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";

// Only `code-fix` verdicts are fixable in code; the select label already
// filters to these, but the re-parse cross-checks the verdict value too.
const AUTOFIX_VERDICT = "code-fix";

// The verdict label the select scans for. Owned by the Stage A ingest bootstrap
// (LABEL_DEFINITIONS) — `code-fix` maps to this label.
export const AUTOFIX_SELECT_LABEL = "sentry:verdict-code-fix";

// The one Sentry project whose source lives in THIS repo (ui-dashboard).
// affected_repo `mento-protocol/monitoring-monorepo` corresponds to this
// project (queue contract / verdict contract). The queue title carries the
// project — `[sentry] <SHORT-ID> (<project>, <level>)` — so the batch list can
// cheaply pre-filter to this project BEFORE the per-candidate verdict read.
// This is the starvation guard: `sentry:verdict-code-fix` is never removed, so
// EXTERNAL-repo code-fix stubs (the majority — most Sentry projects are not the
// dashboard) would otherwise accumulate forever and, oldest-first, fill the
// list window ahead of any local candidate. The verdict's affected_repo stays
// the authority (checked in evaluateCandidate); a stub whose project is this
// one but whose verdict names another repo is a triage error whose fix would
// not live here anyway, so dropping it here is the correct, cheap direction.
export const LOCAL_SENTRY_PROJECT = "analytics-mento-org";

const QUEUE_TITLE_PROJECT_PATTERN = /^\[sentry\]\s+\S+\s+\(([^,)]+)[,)]/;

/** Extract the Sentry project from a queue-stub title, or null when unparsable. */
export function parseProject(title) {
  const match = QUEUE_TITLE_PROJECT_PATTERN.exec(String(title ?? ""));
  return match ? match[1].trim() : null;
}

export const DEFAULT_CAP = 2;

// Generous list window: with fixed stubs excluded server-side and the project
// pre-filter above, the eligible-and-unfixed local set stays tiny, so this is
// only a safety ceiling — not the throttle. Oldest-first, so genuinely old
// candidates are never starved by newer ones.
const LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// GitHub I/O (via `gh`, mirroring the ingest/digest/project scripts). `runGh`
// is injectable so tests drive the full flow with mocked I/O.
// ---------------------------------------------------------------------------

function defaultRunGh(args) {
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

/**
 * Oldest-first list of candidate `sentry:verdict-code-fix` queue stubs. Two
 * server-side narrowings keep the fixed-window from starving out genuinely-old
 * candidates (the verdict label is never removed, so stubs accumulate):
 *   - `-label:sentry:fix-pr-opened -label:sentry:fix-refused` excludes stubs
 *     this leg already handled (opened a PR for, or attempted and refused);
 *   - the LOCAL_SENTRY_PROJECT title pre-filter (applied here, client-side off
 *     the returned title) drops EXTERNAL-repo code-fix stubs before their
 *     verdict is ever read.
 * Oldest-first via `sort:created-asc`, capped at LIST_LIMIT as a safety ceiling.
 */
async function listCodeFixStubs(runGh, repo) {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    AUTOFIX_SELECT_LABEL,
    "--state",
    "all",
    // Exclude everything that does not belong in the window AT THE SOURCE:
    // `--limit` caps what the API RETURNS before any client-side filter runs,
    // so an accumulating backlog of not-for-us stubs that sort BEFORE newer
    // local candidates would silently starve them out of the window. Two axes:
    //   - Handled/external markers: `fix-pr-opened` (a PR was opened) and
    //     `fix-refused` (an attempt declined) are terminal until a human clears
    //     them or a regression sheds them; `sentry:projected` marks external
    //     code-fix stubs whose verdict was projected into the owning repo.
    //   - Owning PROJECT, by title: the `sentry:projected` exclusion alone is
    //     not enough — the projection workflow's documented `skipped-no-token`
    //     path CLOSES external code-fix stubs while KEEPING the verdict label
    //     and WITHOUT adding `sentry:projected`, so those would slip past the
    //     label filter and fill the window. `<slug> in:title` restricts to
    //     titles containing this repo's Sentry project slug; GitHub tokenizes
    //     the hyphenated slug and ANDs the tokens (`analytics` AND `mento` AND
    //     `org`), which — across the org's `*-mento-org` / `*-api` / `-dapp`
    //     projects — matches only this project's stubs. The exact client-side
    //     `parseProject === LOCAL_SENTRY_PROJECT` check below stays as the
    //     precise gate (this server filter only needs to keep the WINDOW local).
    "--search",
    `sort:created-asc -label:"${FIX_PR_OPENED_LABEL}" -label:"${FIX_REFUSED_LABEL}" -label:"${PROJECTED_LABEL}" ${LOCAL_SENTRY_PROJECT} in:title`,
    "--json",
    "number,title,labels,createdAt",
    "--limit",
    String(LIST_LIMIT),
  ]);
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [];
  return (
    list
      .map((issue) => ({
        number: issue.number,
        title: issue.title ?? "",
        createdAt: issue.createdAt ?? "",
        labels: (issue.labels ?? [])
          .map((label) => (typeof label === "string" ? label : label?.name))
          .filter(Boolean),
      }))
      // Exact owning-project gate — the server-side `<slug> in:title` filter
      // keeps the WINDOW local (tokenized, so approximate); this parses the
      // exact project out of the title and drops any tokenized false-positive.
      .filter((issue) => parseProject(issue.title) === LOCAL_SENTRY_PROJECT)
      // `--search sort:created-asc` returns oldest-first, but keep the client-side
      // sort as defense-in-depth (same pattern as the triage select job).
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  );
}

/** Read a queue stub's title/labels/comments so it can be evaluated in full. */
async function readStub(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

/** True when an OPEN autofix PR already exists for this SHORT-ID — the autofix
 * leg must never open a second fix PR for a Sentry issue that already has one.
 * Matched by the DETERMINISTIC head branch (`sentry-autofix/<short-id-lower>`),
 * NOT by a text search: a free-text `--search "<SHORT-ID>"` matches any open PR
 * whose body/title merely mentions the id (a human PR, a dependency bump, an
 * unrelated fix that cites the Sentry issue), which would both falsely dedup an
 * eligible stub out of selection AND — via the reconcile path — mislabel the
 * stub `sentry:fix-pr-opened` pointing at that unrelated PR. The head branch is
 * in our own namespace and one-to-one with the SHORT-ID, so a `--head` match is
 * exact and cannot be spoofed by PR prose. `--state open` only: a merged/closed
 * PR is not a live dedup (a regressed, re-triaged issue must be re-attemptable).
 * The branch name is derived from the shape-validated SHORT-ID and transits
 * `gh` as an argv element, so it can't inject. */
async function openAutofixPrExists(runGh, repo, shortId) {
  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    autofixBranchName(shortId),
    "--state",
    "open",
    "--json",
    "number",
    "--limit",
    "1",
  ]);
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) && parsed.length > 0;
}

/**
 * Evaluate ONE candidate stub against every autofix filter. Returns
 * `{ issue, shortId }` when it should be fixed, or `null` (with a stderr note)
 * otherwise. `stub` needs `{ number, title, labels }`; the verdict comments are
 * read here. Never throws — a parse failure is a skip, so the select job always
 * emits a valid array.
 */
async function evaluateCandidate(runGh, repo, stub) {
  // Dedup by label first (cheapest, no extra API call). Both autofix markers
  // are terminal until a human clears them or a regression sheds them — this
  // also covers the single-issue dispatch path, which bypasses the server-side
  // list filter.
  if (stub.labels.includes(FIX_PR_OPENED_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: already carries ${FIX_PR_OPENED_LABEL}.\n`,
    );
    return null;
  }
  if (stub.labels.includes(FIX_REFUSED_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: already carries ${FIX_REFUSED_LABEL} (remove it to retry).\n`,
    );
    return null;
  }
  if (!stub.labels.includes(AUTOFIX_SELECT_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: not labeled ${AUTOFIX_SELECT_LABEL}.\n`,
    );
    return null;
  }

  const shortId = parseShortId(stub.title);
  if (!isValidShortId(shortId)) {
    process.stderr.write(
      `skip #${stub.number}: no parseable Sentry SHORT-ID in title.\n`,
    );
    return null;
  }

  let parsed;
  try {
    const full = await readStub(runGh, repo, stub.number);
    ({ parsed } = resolveVerdict(full, stub.number));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`skip #${stub.number}: ${message}\n`);
    return null;
  }

  // Cross-check the verdict value and require an EXACTLY-local owning repo.
  // `unrecognized` also resolves to LOCAL_REPO in validateAffectedRepo, but we
  // fix here ONLY when the agent named this repo verbatim — an unrecognized
  // value is not a confident local classification.
  if (parsed.verdict !== AUTOFIX_VERDICT) {
    process.stderr.write(
      `skip #${stub.number}: verdict is ${parsed.verdict}, not ${AUTOFIX_VERDICT}.\n`,
    );
    return null;
  }
  const repoCheck = validateAffectedRepo(parsed.affectedRepo);
  if (repoCheck.reason !== "local-repo") {
    process.stderr.write(
      `skip #${stub.number}: affected_repo is not exactly this repo (${repoCheck.reason}).\n`,
    );
    return null;
  }

  // An OPEN autofix PR already exists on this SHORT-ID's deterministic branch.
  // Because the two terminal markers were filtered above, reaching here means
  // the stub has NEITHER marker yet its fix PR exists — i.e. a prior run's `gh
  // pr create` succeeded but its follow-up queue comment/label write did not
  // land (a transient failure, or a same-tick race with a concurrent run). This
  // is NOT a plain skip: the stub's queue side-effects are unreconciled and
  // would never be repaired if we dropped it (the workflow's reconcile path is
  // only reachable AFTER selection). Emit it as a RECONCILE entry — the fix job
  // routes reconcile entries to a no-agent step that (re-)applies the marker +
  // comment against the existing PR, never opening a duplicate and never
  // re-running the agent (which could otherwise mislabel it `fix-refused`).
  if (await openAutofixPrExists(runGh, repo, shortId)) {
    process.stderr.write(
      `reconcile #${stub.number}: an open autofix PR exists for ${shortId} but the stub lacks its marker; routing to no-agent reconciliation.\n`,
    );
    return { issue: stub.number, shortId, reconcile: true };
  }

  return { issue: stub.number, shortId };
}

/**
 * Select queue stubs to attempt a scoped fix PR for. Batch mode (default):
 * up to `cap` oldest `sentry:verdict-code-fix` stubs owned by this repo.
 * Single mode (`options.issue`): evaluate only that issue (the single-issue
 * `workflow_dispatch` live run) through the SAME filters — so a dispatch can
 * never fix an ineligible issue, but an eligible one opens a real PR. Returns
 * `[{ issue, shortId }]`.
 */
export async function selectAutofixCandidates(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_REPO;

  // Single-issue live run: evaluate exactly the requested issue.
  if (options.issue != null) {
    const stub = await readStub(runGh, repo, options.issue);
    const entry = await evaluateCandidate(runGh, repo, {
      number: stub.number,
      title: stub.title,
      labels: stub.labels,
    });
    return entry ? [entry] : [];
  }

  const cap =
    Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : DEFAULT_CAP;
  const stubs = await listCodeFixStubs(runGh, repo);
  const selected = [];
  for (const stub of stubs) {
    if (selected.length >= cap) break;
    const entry = await evaluateCandidate(runGh, repo, stub);
    if (entry) selected.push(entry);
  }
  return selected;
}

/**
 * Emit the trusted, fence-selected verdict comment body for one issue, so the
 * workflow can snapshot it to a file the fix agent reads — instead of giving the
 * agent a `gh` tool + GitHub token (which a prompt-injected agent could try to
 * exfiltrate from its process env). Uses the SAME authorship/regression fence
 * as the label + projection steps. Throws if there is no usable verdict.
 */
export async function emitVerdict(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const stub = await readStub(
    runGh,
    options.repo ?? DEFAULT_REPO,
    options.issue,
  );
  const selected = selectVerdictComment(stub.comments);
  if (!selected.body) {
    throw new Error(
      `No usable verdict comment on issue #${options.issue} (${selected.reason}).`,
    );
  }
  return selected.body;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:autofix:select [--repo <owner/name>] [--cap <n>]

Prints a JSON array of { "issue": <number>, "shortId": "<SHORT-ID>" } matrix
entries — the oldest capped batch of code-fix queue stubs owned by this repo
that do not yet have a fix PR. Diagnostics go to stderr.

Options:
  --repo <owner/name>  Repo the queue stubs live in (default: ${DEFAULT_REPO}).
  --cap <n>            Max stubs to select per run (positive int; default ${DEFAULT_CAP}).
  --issue <n>          Single-issue live run: evaluate ONLY this issue through the
                       same filters (the workflow_dispatch path). Opens a real
                       fix PR if the issue is eligible. Overrides --cap.
  --emit-verdict       With --issue: print the trusted (fence-selected) verdict
                       comment body for that issue and exit (the workflow
                       snapshots it to a file the fix agent reads, so the agent
                       needs no gh tool or token).
  -h, --help           Show this help.
`;
}

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    cap: DEFAULT_CAP,
    issue: null,
    emitVerdict: false,
    help: false,
  };
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
      case "--cap": {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--cap must be a positive integer");
        }
        options.cap = value;
        break;
      }
      case "--issue": {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--issue must be a positive integer");
        }
        options.issue = value;
        break;
      }
      case "--emit-verdict":
        options.emitVerdict = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.emitVerdict) {
    if (options.issue == null) {
      throw new Error("--emit-verdict requires --issue <n>");
    }
    process.stdout.write(await emitVerdict(options));
    return;
  }
  const selected = await selectAutofixCandidates(options);
  process.stdout.write(`${JSON.stringify(selected)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
