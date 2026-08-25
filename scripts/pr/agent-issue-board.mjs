#!/usr/bin/env node
/**
 * Keep the agent issue labels authoritative while projecting that state onto
 * the repo's GitHub Projects workboard.
 *
 * This file is the entry point and the public surface. The implementation
 * lives in six layers it composes:
 *   - `issue-board-state.mjs`     pure transitions and predicates
 *   - `issue-board-cli.mjs`       argv parsing and usage text
 *   - `issue-board-transport.mjs` the bounded `gh` runner and issue readers
 *   - `issue-board-projects.mjs`  Projects V2 field IO
 *   - `issue-board-backfill.mjs`  trusted claim recovery and fill-only plans
 *   - `issue-board-commands.mjs`  claim, review, release, sync, backfill
 */

import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "./issue-board-cli.mjs";
import {
  claim,
  backfill,
  release,
  renderResults,
  review,
  sync,
} from "./issue-board-commands.mjs";

export { parseArgs, parseIssueNumbers } from "./issue-board-cli.mjs";
export {
  backfill,
  buildClaimComment,
  IssueBoardSyncError,
  sync,
} from "./issue-board-commands.mjs";
export {
  buildBackfillPlan,
  parseClaimComment,
  selectNewestTrustedClaim,
} from "./issue-board-backfill.mjs";
export { githubProjectScopeHint } from "./issue-board-transport.mjs";
export {
  chooseUntriedCandidate,
  DEFAULT_PROJECT_NUMBER,
  DEFAULT_PROJECT_OWNER,
  DEFAULT_REPO,
  isClaimable,
  isBackfillable,
  isRecoverableClaimRaceError,
  isReleasable,
  isReviewable,
  ISSUE_STATE_LABELS,
  labelsForState,
  projectDateFieldValue,
  projectPrFieldValue,
  selectStatusOption,
  shouldRollbackFailedTransition,
  stateFromLabels,
  validateOpenPr,
} from "./issue-board-state.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(usage());
    return;
  }

  let results;
  switch (options.command) {
    case "claim":
      results = await claim(options);
      break;
    case "backfill":
      results = await backfill(options);
      break;
    case "review":
      results = await review(options);
      break;
    case "release":
      results = await release(options);
      break;
    case "sync":
      results = await sync(options);
      break;
    default:
      throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ issues: results }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderResults(results)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
