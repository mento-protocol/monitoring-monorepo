/**
 * Argv surface of the verdict-projection leg (`sentry-triage-project.mjs`).
 *
 * Split out of that entry module (#1827) purely on size: it was over the
 * 1,000-line hard cap in docs/pr-checklists/recurring-review-patterns.md and
 * scripts/ has no `max-lines` lint to catch it. This is the cleanest seam the
 * file has — help text and argument validation depend on nothing but the
 * contract constants, while everything left behind is `gh` I/O and the mode
 * drivers, so the two sides share no state and the cut needed no logic changes.
 *
 * The entry module re-exports `parseArgs` and `parseIssueNumbers`, so the
 * import surface tests and consumers use is unchanged.
 */

import {
  DEFAULT_REPO,
  isPriorVerdictToken,
  PRIOR_VERDICT_NONE,
  PRIOR_VERDICT_UNKNOWN,
  PROJECTED_LABEL,
  VALID_VERDICTS,
} from "./sentry-triage-project-core.mjs";
import { parseEnsureLabelNames } from "./sentry-triage-label-ensure.mjs";

export function usage() {
  return `Usage: pnpm sentry:project --issue <queue-issue-number> [options]

Deterministically projects an actionable (code-fix/config-fix) triage verdict
for an EXTERNAL owning repo into a human-readable issue in that repo, labels the
queue stub ${PROJECTED_LABEL}, and comments the projected issue URL. Prints a
single-line JSON result ({"status": "...", "url": "..."}) to stdout; diagnostics
and workflow annotations go to stderr.

Statuses: projected | reused | skipped-verdict | skipped-repo | skipped-no-token
(batch rows additionally: skipped-state | failed)

Options:
  --issue <number>     Queue issue number to project (positive int; required
                       unless --batch).
  --batch              Serialized batch mode (the workflow's project job):
                       process --issues one at a time in ONE process, sharing
                       an in-run registry so duplicate-family SHORT-IDs can
                       never double-file while GitHub search still lags issue
                       creation. Emits a JSON array of per-issue result rows.
  --issues <json>      JSON array of queue-issue numbers (batch mode).
  --repo <owner/name>  Repo the queue stub lives in (default: ${DEFAULT_REPO}).
  --parse-only         Resolve and print the validated verdict + mapped label +
                       projectability + shed list + architecturalHold
                       ({"verdict","label","projectable","shed","architecturalHold"}
                       JSON) without projecting. \`label\` is a comma list on a
                       local code-fix + fix_scope:architectural verdict (adds
                       sentry:fix-scope-architectural), and architecturalHold then
                       tells the close step to leave the stub open. Used by the
                       workflow's label step so labeling and projection share ONE
                       parser. Fails (exit 1) on a missing, stale pre-regression,
                       or invalid verdict comment.
  --prior-verdicts     Print {"<issue>": "<comment-id>|${PRIOR_VERDICT_NONE}|${PRIOR_VERDICT_UNKNOWN}"} for
                       --issues: the verdict comment already on each stub. Run
                       by the SELECT job, before the triage agent, to record
                       what the round started from (issue #1717).
  --prior-verdict-comment <token>
                       With --parse-only: the id --prior-verdicts recorded for
                       this stub (or ${PRIOR_VERDICT_NONE} / ${PRIOR_VERDICT_UNKNOWN}). The resolution
                       then refuses (exit 1) unless the verdict comment it
                       selects is strictly newer, so a triage round that posted
                       nothing cannot settle the stub on the previous round's
                       verdict.
  --verdict <value>    Already-validated verdict from the label step. When set,
                       the script fails loud if its own parse of the newest
                       verdict comment disagrees (never a silent skip).
  --ensure-labels <names>
                       Comma list of labels to self-heal from Stage A's
                       LABEL_DEFINITIONS (\`gh label create --force\`) before a
                       caller writes them. Run by the workflow's label step with
                       every name its \`gh issue edit\` uses — added, shed, and
                       \`sentry:needs-triage\` — because gh fails the whole edit
                       on a label the repo does not have, on --remove-label just
                       as on --add-label. Needs no --issue; best-effort per
                       label, so it exits 0 even when a create fails.
  -h, --help           Show this help.

Env:
  SENTRY_PROJECTION_TOKEN  Fine-grained PAT (Issues R/W on the three owning
                           repos) for the cross-repo create/search. Absent ->
                           graceful no-op (status skipped-no-token).
  GH_TOKEN                 Ambient github.token for local queue-stub mutations.
`;
}

/** Parse a `--issues` JSON array of positive integers (the select job's
 * output). Fails loud on anything else. */
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

export function parseArgs(argv, env = process.env) {
  const options = {
    localRepo: DEFAULT_REPO,
    queueIssue: null,
    queueIssues: [],
    batch: false,
    parseOnly: false,
    priorVerdicts: false,
    priorVerdictCommentId: null,
    expectedVerdict: null,
    ensureLabels: null,
    help: false,
  };
  let issuesRaw = null;
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--issue":
        options.queueIssue = Number(readValue());
        break;
      case "--issues":
        issuesRaw = readValue();
        break;
      case "--batch":
        options.batch = true;
        break;
      case "--repo":
        options.localRepo = readValue();
        break;
      case "--parse-only":
        options.parseOnly = true;
        break;
      case "--prior-verdicts":
        options.priorVerdicts = true;
        break;
      case "--prior-verdict-comment": {
        // A bare comment id, `none`, or `unknown` — the closed set
        // `--prior-verdicts` emits. Anything else is a wiring bug between the
        // two jobs, and a wiring bug that silently degraded to "unbound" would
        // remove the fence without saying so, so it fails loud here.
        const value = readValue();
        if (!isPriorVerdictToken(value)) {
          throw new Error(
            `--prior-verdict-comment must be a numeric comment id, ${PRIOR_VERDICT_NONE}, or ${PRIOR_VERDICT_UNKNOWN}, got: ${value}`,
          );
        }
        options.priorVerdictCommentId = value;
        break;
      }
      case "--verdict": {
        // Comes from the label step's closed-enum output; anything else is a
        // wiring bug — fail loud rather than carrying an invalid expectation.
        const value = readValue();
        if (!VALID_VERDICTS.includes(value)) {
          throw new Error(
            `--verdict must be one of ${VALID_VERDICTS.join(", ")}, got: ${value}`,
          );
        }
        options.expectedVerdict = value;
        break;
      }
      case "--ensure-labels":
        options.ensureLabels = parseEnsureLabelNames(readValue());
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.help) {
    // Only --parse-only consumes the token. Accepting it on a projection run
    // would silently drop the fence, which is the one failure mode the flag
    // exists to prevent — so an unconsumed token is a wiring bug, not a no-op.
    if (options.priorVerdictCommentId !== null && !options.parseOnly) {
      throw new Error(
        "--prior-verdict-comment is only consumed by --parse-only; pass both or neither",
      );
    }
    // Label self-heal is its own mode: it touches no stub and resolves no
    // verdict, so an invocation that also asks for one of those gets neither
    // silently. The DEFAULT mode is the one to be careful about — it is not a
    // flag at all, just `--issue` plus an optional `--verdict` cross-check — so
    // a guard that only rejected the FLAGGED modes would let
    // `--issue 5 --verdict code-fix --ensure-labels …` ensure the labels, skip
    // the projection entirely, and exit 0 reporting success for a no-op. Every
    // mode-bearing input is therefore rejected by name. The label step runs
    // ensure and edit as separate, ordered invocations on purpose, so nothing
    // legitimately needs both.
    if (options.ensureLabels !== null) {
      const alsoRequested = [
        options.batch && "--batch",
        options.parseOnly && "--parse-only",
        options.priorVerdicts && "--prior-verdicts",
        issuesRaw !== null && "--issues",
        options.queueIssue !== null && "--issue",
        options.expectedVerdict !== null && "--verdict",
      ].filter(Boolean);
      if (alsoRequested.length > 0) {
        throw new Error(
          `--ensure-labels is a standalone mode; run it in its own invocation (also passed: ${alsoRequested.join(", ")})`,
        );
      }
    }
    if (options.batch || options.priorVerdicts) {
      options.queueIssues = parseIssueNumbers(issuesRaw);
    } else if (
      options.ensureLabels === null &&
      (!Number.isInteger(options.queueIssue) || options.queueIssue <= 0)
    ) {
      throw new Error("--issue must be a positive integer");
    }
  }
  options.projectionToken = (env.SENTRY_PROJECTION_TOKEN ?? "").trim();
  return options;
}
