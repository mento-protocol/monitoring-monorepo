/**
 * The `--schedule-issue` mode: read the ledger's freshness, and open at most
 * one staleness issue per contract per month. Split out of `review-eval.mjs`
 * for line headroom; that file re-exports `runScheduleIssue`, so importers are
 * unchanged.
 *
 * Every import here reaches past `review-eval.mjs` and the `review-eval-run.mjs`
 * barrel to the module that defines the symbol, because `review-eval.mjs`
 * imports this one.
 */

import path from "node:path";

import {
  ensureLabelsExist,
  ghPaginate,
  normalizeIssuePages,
  runGh,
} from "../lib/gh-issue-lifecycle.mjs";
import {
  assertAuthorizedFreshnessWorkflow,
  planStalenessIssueSync,
} from "./review-eval-freshness-guard.mjs";
import { freshness, readLedger } from "./review-eval-ledger.mjs";
import {
  parseLeadingReviewEvalMarkers,
  REVIEW_EVAL_OWNERSHIP_LABEL,
  scheduleIssuePayload,
} from "./review-eval-report.mjs";

async function defaultListIssues(options) {
  const pages = await ghPaginate(`repos/${options.repo}/issues?state=all`);
  return normalizeIssuePages(pages, {
    ownershipLabel: REVIEW_EVAL_OWNERSHIP_LABEL,
    parseMarker: parseLeadingReviewEvalMarkers,
  });
}

async function defaultCreateIssue(options, payload) {
  return runGh([
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    payload.title,
    "--body",
    payload.body,
    "--label",
    payload.labels.join(","),
  ]);
}

export async function runScheduleIssue(options, context, deps = {}) {
  const {
    listIssues = defaultListIssues,
    authorize = assertAuthorizedFreshnessWorkflow,
    ensureLabels = ensureLabelsExist,
    createIssue = defaultCreateIssue,
    now = new Date(options.now ?? `${options.date}T00:00:00Z`),
  } = deps;
  const rows = readLedger(path.resolve(context.repoRoot, options.ledgerPath));
  const age = freshness({
    rows,
    contract: context.contract,
    now,
    contractDigest: context.contractDigest,
  });
  const payload = scheduleIssuePayload({
    freshnessResult: age,
    contract: context.contract,
    contractDigest: context.contractDigest,
    month: options.date.slice(0, 7),
  });
  if (!payload) {
    return {
      action: "skip-fresh",
      reason: `ledger is fresh: ${age.daysSinceAny} day(s) since the newest run`,
      level: age.level,
      reasons: age.reasons,
      mutated: false,
    };
  }
  const issues = await listIssues(options);
  const decision = planStalenessIssueSync({
    month: options.date.slice(0, 7),
    contractDigest: context.contractDigest,
    issues,
    payload,
  });
  let mutated = false;
  if (decision.action === "create" && !options.dryRun) {
    await authorize(options);
    await ensureLabels(options);
    await createIssue(options, payload);
    mutated = true;
  }
  return {
    action: decision.action,
    reason: decision.reason,
    issue_number: decision.issue?.number ?? null,
    level: age.level,
    reasons: age.reasons,
    title: payload.title,
    dry_run: options.dryRun,
    mutated,
  };
}
