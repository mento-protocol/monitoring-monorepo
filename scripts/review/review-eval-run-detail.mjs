// Detail-directory naming and the pre-split cell cache for one eval run.
//
// The directory a plan writes to is also its resume cache, so naming it and
// deciding which earlier directory a retry may seed from are one concern. It
// was split out of `review-eval-run-plan.mjs` for file-size headroom and is
// registered in `SCORING_MODULES` because a name it hands back decides which
// paid cells a run reuses, which decides what the row records.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { finderDetailSegment } from "./review-eval-finder-override.mjs";
import {
  cellReuseDecision,
  LEGACY_SPLIT_CACHE_PLAN,
  legacySplitCachePlanMatches,
} from "./review-eval-run-cell.mjs";

/** The committed root every run's detail directory lives under. */
export const DEFAULT_RUNS_DIR = "docs/evals/review-skill-runs";

// How many executions of one date, key, kind and skill the runs directory may
// hold before the plan refuses to name another. Reaching it means a script is
// re-running the same matrix in a loop, which is a bug worth stopping on.
const MAX_RUNS_PER_NAME = 50;

function reusableCellResultCount({ cellsDir, cells, plan }) {
  try {
    if (!lstatSync(cellsDir).isDirectory()) return 0;
    return cells.filter((cell) => {
      const resultPath = path.join(cellsDir, cell.cell_id, "result.json");
      try {
        return (
          lstatSync(resultPath).isFile() &&
          cellReuseDecision({ plan, resultPath }).reuse
        );
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Find the one pre-split cache whose raw cells the recorded split preserves.
 * The first plan runs in the clean spec worktree and does not scan. The second
 * plan writes to the real checkout, so its conventional out directory names
 * the physical runs directory that can hold the ignored cell cache.
 */
export function resolveLegacySplitCache({
  runsDir,
  outDir,
  detailDir,
  contractDigest,
  calibrationDigest,
  kind,
  inputs,
  cells,
}) {
  if (
    runsDir !== DEFAULT_RUNS_DIR ||
    !outDir ||
    path.basename(path.resolve(outDir)) !== path.posix.basename(detailDir) ||
    existsSync(path.join(path.resolve(outDir), "cells"))
  ) {
    return null;
  }
  const physicalRunsDir = path.dirname(path.resolve(outDir));
  if (
    path.basename(physicalRunsDir) !== path.posix.basename(DEFAULT_RUNS_DIR)
  ) {
    return null;
  }
  let entries;
  try {
    entries = readdirSync(physicalRunsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const prefix = LEGACY_SPLIT_CACHE_PLAN.comparabilityKey.slice(0, 8);
  const skill = String(inputs.skill_digest).slice(0, 8);
  const namePattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}-${prefix}-${kind}-${skill}${finderDetailSegment({ kind, inputs })}(?:-(?:[2-9]|[1-4]\\d|50))?$`,
  );
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !namePattern.test(entry.name)) continue;
    const relative = path.posix.join(runsDir, entry.name);
    const physical = path.join(physicalRunsDir, entry.name);
    let cachedPlan;
    try {
      const planPath = path.join(physical, "plan.json");
      if (!lstatSync(planPath).isFile()) continue;
      cachedPlan = JSON.parse(readFileSync(planPath, "utf8"));
    } catch {
      continue;
    }
    if (
      !legacySplitCachePlanMatches({
        plan: cachedPlan,
        detailDir: relative,
        contractDigest,
        calibrationDigest,
        kind,
        inputs,
        cells,
      })
    ) {
      continue;
    }
    const results = reusableCellResultCount({
      cellsDir: path.join(physical, "cells"),
      cells,
      plan: { kind, contract_digest: contractDigest, inputs },
    });
    const plannedAt =
      typeof cachedPlan.planned_at === "string" ? cachedPlan.planned_at : "";
    if (
      results > 0 &&
      (!best ||
        results > best.results ||
        (results === best.results && plannedAt > best.plannedAt) ||
        (results === best.results &&
          plannedAt === best.plannedAt &&
          relative > best.relative))
    ) {
      best = { relative, results, plannedAt };
    }
  }
  return best?.relative ?? null;
}

/**
 * The detail directory this execution owns, and the one it may resume from.
 *
 * The base name — date, comparability key, kind, skill digest — is the resume
 * cache: an execution killed before it recorded anything is retried by running
 * the same command, and it must land on its own cells rather than re-spend the
 * matrix. But that directory is also the evidence a ledger row points at, so
 * once a row records it the next execution must not write there: it would
 * overwrite the plan, the scored results, the row and the report the earlier row
 * still claims, and reuse that row's publication branch name. So the name is
 * taken as soon as a row records it, and this execution takes the next one and
 * names the directory it superseded, whose paid cells the orchestrator seeds
 * from — every one of them is re-checked against this run's fingerprint.
 */
export function resolveDetailDir({ runsDir, base, ledgerRows = [] }) {
  const taken = new Set(
    (ledgerRows ?? []).map((row) => String(row?.detail_dir ?? "")),
  );
  let previous = null;
  for (let attempt = 1; attempt <= MAX_RUNS_PER_NAME; attempt += 1) {
    const candidate = path.posix.join(
      runsDir,
      attempt === 1 ? base : `${base}-${attempt}`,
    );
    if (!taken.has(candidate)) {
      return { detailDir: candidate, resumeFrom: previous };
    }
    previous = candidate;
  }
  throw new Error(
    `the ledger already records ${MAX_RUNS_PER_NAME} runs named ${path.posix.join(runsDir, base)}; refusing to plan another`,
  );
}
