import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  nonRegularEvidenceProblems,
  planProvenanceProblems,
} from "./review-eval-plan-evidence.mjs";
import {
  runEvidenceDigest,
  runEvidenceProblems,
} from "./review-eval-run-evidence.mjs";
import { comparabilityKey, fileDigest } from "./review-eval-run.mjs";
import { resolveBaseline, revalidateRow } from "./review-eval-result-shape.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

/**
 * Recompute every row this branch appends, from the detail the same branch
 * commits. `checkLedger` proves a ledger PR is schema-valid, covers the frozen
 * ids and adds rows without editing older ones — and nothing more. Editing a
 * committed row's `verdict`, its counters or a `per_defect` bit before opening
 * the PR left all three checks green while the committed report no longer
 * matched its own cell and calibration evidence, and `--validate` ran only on
 * the operator's machine before the commit.
 *
 * No model is called: `revalidateRow` reads the committed `result-*.json` and
 * `calibration.json` files. The job that runs this holds no model credential.
 */
export function revalidateAppendedRows({ options, context, result, base }) {
  const problems = [];
  const rows = result.rows;
  // Which rows are new is the base comparison's answer. An unresolvable base
  // ref leaves that unanswerable — recomputing the whole history would judge
  // rows of retired contracts, and checking nothing is a guard that silently
  // no-ops. A base that resolves but carries no ledger is the bootstrap case:
  // every row on this branch is appended, zero rows included.
  if (!base.rows && !base.resolved) {
    result.problems.push(
      `--revalidate-appended cannot tell which rows are new: ${base.reason}`,
    );
    return { ok: false, checked: null, unpaired: null };
  }
  const appended = base.rows ? rows.slice(base.rows.length) : rows;
  const calibrationFile = path.resolve(
    context.repoRoot,
    options.calibrationPath,
  );
  const calibrationSet = existsSync(calibrationFile)
    ? readJson(calibrationFile)
    : null;
  const expectedComparabilityKey = comparabilityKey({
    contract: context.contract,
    contractDigest: context.contractDigest,
    calibrationDigest: fileDigest(calibrationFile),
  });
  const repoRoot = realpathSync(context.repoRoot);
  const detailDirectoryIdentity = (detailDir, label) => {
    const resolved = path.resolve(repoRoot, detailDir);
    const insideRepo = (target) => {
      const relative = path.relative(repoRoot, target);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    };
    if (!insideRepo(resolved)) {
      problems.push(`${label} names detail_dir ${detailDir} outside the repo`);
      return null;
    }
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    if (!insideRepo(canonical)) {
      problems.push(`${label} names detail_dir ${detailDir} outside the repo`);
      return null;
    }
    if (canonical === repoRoot) {
      problems.push(`${label} names the repository root as detail_dir`);
      return null;
    }
    return canonical;
  };
  const usedDetailDirs = new Set();
  const usedEvidence = new Map();
  const baseDetailPaths = new Map();
  for (const row of base.rows ?? []) {
    if (typeof row.detail_dir !== "string") continue;
    const identity = detailDirectoryIdentity(
      row.detail_dir,
      `base row ${row.executed_at}`,
    );
    if (identity !== null) {
      usedDetailDirs.add(identity);
      baseDetailPaths.set(
        path
          .relative(repoRoot, path.resolve(repoRoot, row.detail_dir))
          .split(path.sep)
          .join("/"),
        row.executed_at,
      );
      baseDetailPaths.set(
        path.relative(repoRoot, identity).split(path.sep).join("/"),
        row.executed_at,
      );
      problems.push(
        ...nonRegularEvidenceProblems(identity).map(
          (problem) => `base row ${row.executed_at}: ${problem}`,
        ),
      );
      if (row.kind !== "bridge" && row.status !== "failed") {
        const digest = runEvidenceDigest(identity);
        if (digest !== null) {
          usedEvidence.set(digest, `base row ${row.executed_at}`);
        }
      }
    }
  }
  if (base.rows && base.base) {
    const changed = spawnSync(
      "git",
      ["diff", "--name-only", "-z", "--no-renames", base.base, "--"],
      { cwd: repoRoot },
    );
    if (changed.status !== 0) {
      problems.push(
        `could not compare base evidence directories with ${base.base}`,
      );
    } else {
      for (const changedPath of String(changed.stdout)
        .split("\0")
        .filter(Boolean)) {
        for (const [detailPath, executedAt] of baseDetailPaths) {
          if (
            changedPath === detailPath ||
            changedPath.startsWith(`${detailPath}/`) ||
            detailPath.startsWith(`${changedPath}/`)
          ) {
            problems.push(
              `base row ${executedAt} evidence changed at ${changedPath}`,
            );
            break;
          }
        }
      }
    }
  }
  let unpaired = 0;
  for (const row of appended) {
    const label = `appended row ${row.executed_at}`;
    if (!row.detail_dir) {
      problems.push(`${label} carries no detail_dir to recompute from`);
      continue;
    }
    const dir = detailDirectoryIdentity(row.detail_dir, label);
    if (dir === null) continue;
    if (row.kind !== "bridge" && usedDetailDirs.has(dir)) {
      problems.push(
        `${label} reuses detail_dir ${row.detail_dir} from an earlier ledger row`,
      );
      continue;
    }
    usedDetailDirs.add(dir);
    if (!existsSync(dir)) {
      problems.push(
        `${label} names detail_dir ${row.detail_dir}, which this branch does not commit`,
      );
      continue;
    }
    problems.push(
      ...nonRegularEvidenceProblems(dir).map(
        (problem) => `${label}: ${problem}`,
      ),
    );
    if (row.kind !== "bridge" && row.status !== "failed") {
      const digest = runEvidenceDigest(dir);
      const previous = digest === null ? null : usedEvidence.get(digest);
      if (previous) {
        problems.push(
          `${label} reuses scored result and calibration evidence from ${previous}`,
        );
      } else if (digest !== null) {
        usedEvidence.set(digest, label);
      }
    }
    // The recorded pairing is rechecked against the row it actually names, not
    // against whatever anchor this ledger would resolve on its own — those are
    // two different pairs of runs, and comparing the wrong one reports
    // differences that are not errors. A candidate row scored against an
    // installed row whose own ledger PR has not merged yet names a row this
    // branch does not carry; that pairing cannot be rechecked here, so the row
    // is recomputed against its own bits and detail alone and counted as
    // unpaired rather than failed.
    const skipsBaselinePairing = row.status === "failed";
    const recordedAt = row.vs_baseline?.baseline_executed_at ?? null;
    const baselineRow =
      recordedAt === null
        ? null
        : (rows.find((candidate) => candidate.executed_at === recordedAt) ??
          null);
    const missingRecordedBaseline = recordedAt !== null && baselineRow === null;
    const baselineSelection = row.vs_baseline?.selection ?? null;
    const candidateMissingBaseline =
      missingRecordedBaseline &&
      row.inputs?.dirty === true &&
      row.inputs?.skill_ref !== "installed" &&
      baselineSelection === "explicit";
    if (
      !skipsBaselinePairing &&
      missingRecordedBaseline &&
      !candidateMissingBaseline
    ) {
      problems.push(
        `${label}: baseline ${recordedAt} is not in the ledger; only a dirty --skill-ref candidate row with explicit selection may waive a missing baseline`,
      );
    }
    const baselineMissing = candidateMissingBaseline;
    if (baselineMissing) unpaired += 1;
    if (
      !skipsBaselinePairing &&
      recordedAt !== null &&
      baselineSelection === null
    ) {
      problems.push(
        `${label}: vs_baseline.selection must record automatic or explicit baseline selection`,
      );
    }
    const baselineIsExplicit =
      row.kind === "bridge" || baselineSelection === "explicit";
    if (!skipsBaselinePairing && !baselineMissing && !baselineIsExplicit) {
      const resolvedBaseline = resolveBaseline({ rows, row });
      const sameBaseline =
        resolvedBaseline === baselineRow ||
        (resolvedBaseline !== null &&
          baselineRow !== null &&
          resolvedBaseline.executed_at === baselineRow.executed_at &&
          resolvedBaseline.contract_digest === baselineRow.contract_digest &&
          resolvedBaseline.detail_dir === baselineRow.detail_dir);
      if (
        !sameBaseline &&
        !(resolvedBaseline === null && baselineRow === null)
      ) {
        problems.push(
          `${label}: recorded baseline ${recordedAt ?? "none"} does not match the append-order baseline ${resolvedBaseline?.executed_at ?? "none"}`,
        );
      }
    }
    const check = revalidateRow({
      contract: context.contract,
      row,
      repoRoot: context.repoRoot,
      detailDir: dir,
      ledgerRows: baselineMissing || skipsBaselinePairing ? [] : rows,
      baselineRow: skipsBaselinePairing ? null : baselineRow,
      baselineIsExplicit,
      // Half the verdict is the pairing: a regression and a promotion are both
      // read out of the flip counts against the anchor. Recomputing an unpaired
      // row without one turns a recorded RED or PROMOTE into GREEN and fails
      // the ledger PR for it, over a row the runbook says only counts toward
      // `unpaired_baselines`. The detail checks above are unaffected — they
      // read the row's own bits and its own cell records — so they still run.
      baselineMissing,
      calibrationSet,
    });
    problems.push(...check.problems.map((problem) => `${label}: ${problem}`));
    problems.push(
      ...planProvenanceProblems({
        dir,
        row,
        contract: context.contract,
        baselineRow,
        expectedComparabilityKey,
        requirePortablePlanDir: true,
      }).map((problem) => `${label}: ${problem}`),
    );
    problems.push(
      ...runEvidenceProblems({ dir, row, contract: context.contract }).map(
        (problem) => `${label}: ${problem}`,
      ),
    );
  }
  result.problems.push(...problems);
  return { ok: problems.length === 0, checked: appended.length, unpaired };
}
