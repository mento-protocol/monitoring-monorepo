import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  holdsCellResults,
  nonRegularEvidenceProblems,
  resultEvidenceProblems,
} from "./review-eval-plan-evidence.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

function fixtureScorableIdsByPr(contract) {
  if (!Array.isArray(contract?.fixtures)) return null;
  const indexed = new Map();
  for (const fixture of contract.fixtures) {
    if (
      fixture === null ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      !Number.isSafeInteger(fixture.pr) ||
      !Array.isArray(fixture.scorable_ids)
    ) {
      return null;
    }
    if (!indexed.has(fixture.pr)) {
      indexed.set(fixture.pr, fixture.scorable_ids);
    }
  }
  return indexed;
}

/** Evidence files required for every row that claims scored results. */
export function runEvidenceProblems({ dir, row, contract }) {
  const regularityProblems = nonRegularEvidenceProblems(dir);
  if (regularityProblems.length > 0) return regularityProblems;
  if (row.status === "failed") {
    return readdirSync(dir)
      .filter(
        (name) =>
          name === "calibration.json" ||
          (name.startsWith("result-") && name.endsWith(".json")),
      )
      .map(
        (name) =>
          `${dir} failed row retains scoring artifact ${name}; failed traces must clear scored evidence`,
      );
  }
  const problems = resultEvidenceProblems({ dir, row });
  const fixtureScorableIds = fixtureScorableIdsByPr(contract);
  if (fixtureScorableIds === null) {
    problems.push(
      `${dir} contract.fixtures must be an array of entries with a safe-integer pr and scorable_ids array`,
    );
  }
  const scorableIdsByPr = fixtureScorableIds ?? new Map();
  // A bridge creates no new evidence. It reuses the source full run's plan and
  // scored records, which remain subject to every check below.
  if (!holdsCellResults(dir)) {
    problems.push(`${dir} carries no scored result-*.json files`);
  }
  const planFile = path.join(dir, "plan.json");
  if (existsSync(planFile)) {
    try {
      const plan = readJson(planFile);
      if (Array.isArray(plan.cells)) {
        const rowConditions = new Set(Object.keys(row.conditions ?? {}));
        const planConditions = new Set(
          plan.cells.map((cell) => cell.condition),
        );
        const plannedResults = new Map(
          plan.cells.map((cell) => [
            `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
            cell,
          ]),
        );
        const resultFiles = readdirSync(dir).filter(
          (name) => name.startsWith("result-") && name.endsWith(".json"),
        );
        try {
          const completedCellIds = readJson(
            path.join(dir, "calibration.json"),
          )?.completed_cell_ids;
          if (
            !Array.isArray(completedCellIds) ||
            completedCellIds.some(
              (cellId) => typeof cellId !== "string" || cellId.length === 0,
            )
          ) {
            problems.push(
              `${dir}/calibration.json completed_cell_ids must be an array of non-empty strings`,
            );
          } else {
            const plannedCellIds = new Set(
              plan.cells.map((cell) => cell.cell_id),
            );
            const completedSet = new Set(completedCellIds);
            if (completedSet.size !== completedCellIds.length) {
              problems.push(
                `${dir}/calibration.json completed_cell_ids must not contain duplicates`,
              );
            }
            for (const cellId of completedSet) {
              if (!plannedCellIds.has(cellId)) {
                problems.push(
                  `${dir}/calibration.json records unplanned completed cell ${cellId}`,
                );
              }
            }
            const resultCellIds = resultFiles
              .map((resultFile) => plannedResults.get(resultFile)?.cell_id)
              .filter(Boolean);
            const sorted = (values) => [...values].sort();
            if (
              JSON.stringify(sorted(completedSet)) !==
              JSON.stringify(sorted(new Set(resultCellIds)))
            ) {
              problems.push(
                `${dir} result files do not match calibration.json completed_cell_ids`,
              );
            }
            const expectedStatus =
              completedSet.size === plannedCellIds.size
                ? "complete"
                : "partial";
            if (row.status !== expectedStatus) {
              problems.push(
                `${dir} records ${row.status} status but calibration.json proves a ${expectedStatus} matrix`,
              );
            }
          }
        } catch {
          // The calibration evidence checks report an unreadable record.
        }
        for (const resultFile of resultFiles) {
          const cell = plannedResults.get(resultFile);
          if (!cell) {
            problems.push(`${dir} carries unplanned result file ${resultFile}`);
            continue;
          }
          let record;
          try {
            record = readJson(path.join(dir, resultFile));
          } catch (error) {
            problems.push(
              error instanceof Error ? error.message : String(error),
            );
            continue;
          }
          for (const field of ["cell_id", "pr", "condition", "draw"]) {
            if (record?.[field] !== cell[field]) {
              problems.push(
                `${dir}/${resultFile} ${field} is ${JSON.stringify(record?.[field])}; plan.json recorded ${JSON.stringify(cell[field])}`,
              );
            }
          }
          const fixtureScorableIds = scorableIdsByPr.get(cell.pr);
          if (!Array.isArray(record?.matched_ids)) {
            problems.push(`${dir}/${resultFile} matched_ids must be an array`);
          } else if (fixtureScorableIds) {
            const allowedIds = new Set(fixtureScorableIds.map(String));
            for (const id of record.matched_ids) {
              if (
                !(
                  typeof id === "string" ||
                  (typeof id === "number" && Number.isSafeInteger(id))
                )
              ) {
                problems.push(
                  `${dir}/${resultFile} matched_ids contains non-scalar ${JSON.stringify(id)}`,
                );
              } else if (!allowedIds.has(String(id))) {
                problems.push(
                  `${dir}/${resultFile} matched_ids contains ${JSON.stringify(id)}, which fixture PR ${cell.pr} does not score`,
                );
              }
            }
          }
          const claims = record?.claims;
          if (!Array.isArray(claims)) {
            problems.push(`${dir}/${resultFile} claims must be an array`);
          } else {
            for (const claim of claims) {
              if (typeof claim !== "string" || claim.trim().length === 0) {
                problems.push(
                  `${dir}/${resultFile} claims must contain only non-empty strings`,
                );
                break;
              }
            }
          }
          for (const field of [
            "claims",
            "novelWrong",
            "novelReal",
            "novelVague",
            "restatedKnown",
            "alreadyMatched",
          ]) {
            const value = Number(record?.novel?.[field]);
            if (!Number.isSafeInteger(value) || value < 0) {
              problems.push(
                `${dir}/${resultFile} novel.${field} must be a nonnegative safe integer`,
              );
            }
          }
          if (
            Array.isArray(claims) &&
            record?.novel?.claims !== claims.length
          ) {
            problems.push(
              `${dir}/${resultFile} novel.claims must equal the claims array length`,
            );
          }
          if (
            Array.isArray(record?.matched_ids) &&
            record?.novel?.alreadyMatched !== record.matched_ids.length
          ) {
            problems.push(
              `${dir}/${resultFile} novel.alreadyMatched must equal the matched_ids array length`,
            );
          }
          const verdicts = record?.novel?.verdicts;
          if (
            verdicts === null ||
            typeof verdicts !== "object" ||
            Array.isArray(verdicts)
          ) {
            problems.push(
              `${dir}/${resultFile} novel.verdicts must be an object`,
            );
          } else if (Array.isArray(claims)) {
            const expectedKeys = claims.map((_claim, index) =>
              String(index + 1),
            );
            const actualKeys = Object.keys(verdicts).sort(
              (left, right) => Number(left) - Number(right),
            );
            if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
              problems.push(
                `${dir}/${resultFile} novel.verdicts must carry one numbered verdict per claim`,
              );
            }
            const counts = {
              real: 0,
              wrong: 0,
              vague: 0,
              known: 0,
            };
            let validVerdicts = true;
            for (const verdict of Object.values(verdicts)) {
              if (
                verdict === null ||
                typeof verdict !== "object" ||
                Array.isArray(verdict) ||
                !Object.hasOwn(counts, verdict.class)
              ) {
                validVerdicts = false;
                break;
              }
              counts[verdict.class] += 1;
            }
            if (!validVerdicts) {
              problems.push(
                `${dir}/${resultFile} novel.verdicts carries an invalid class`,
              );
            } else {
              for (const [field, count] of [
                ["novelReal", counts.real],
                ["novelWrong", counts.wrong],
                ["novelVague", counts.vague],
                ["restatedKnown", counts.known],
              ]) {
                if (record?.novel?.[field] !== count) {
                  problems.push(
                    `${dir}/${resultFile} novel.${field} does not match novel.verdicts`,
                  );
                }
              }
            }
          }
          for (const field of ["usd", "seconds"]) {
            const value = record?.[field];
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0
            ) {
              problems.push(
                `${dir}/${resultFile} ${field} must be a nonnegative finite number`,
              );
            }
          }
          if (!rowConditions.has(cell.condition)) {
            problems.push(
              `${dir}/${resultFile} records condition ${cell.condition}, but the row omits it`,
            );
          }
        }
        if (row.status === "complete") {
          for (const condition of planConditions) {
            if (!rowConditions.has(condition)) {
              problems.push(
                `${dir} planned condition ${condition}, but the complete row omits it`,
              );
            }
          }
          for (const condition of rowConditions) {
            if (!planConditions.has(condition)) {
              problems.push(
                `${dir} complete row condition ${condition} has no planned cells`,
              );
            }
          }
          for (const cell of plan.cells) {
            const resultFile = `result-${cell.pr}-${cell.condition}-${cell.draw}.json`;
            if (!resultFiles.includes(resultFile)) {
              problems.push(
                `${dir} carries no ${resultFile} for planned cell ${cell.cell_id ?? "unknown"}`,
              );
            }
          }
        } else {
          const cells = plan.cells.filter((cell) =>
            rowConditions.has(cell.condition),
          );
          for (const condition of rowConditions) {
            const resultCells = cells.filter(
              (cell) =>
                cell.condition === condition &&
                resultFiles.includes(
                  `result-${cell.pr}-${cell.condition}-${cell.draw}.json`,
                ),
            );
            if (resultCells.length === 0) {
              problems.push(
                `${dir} carries no scored result for row condition ${condition}`,
              );
              continue;
            }
            const representedPrs = new Set(resultCells.map((cell) => cell.pr));
            const perDefect = row.conditions?.[condition]?.per_defect ?? {};
            for (const pr of representedPrs) {
              const missingIds = (scorableIdsByPr.get(pr) ?? [])
                .map(String)
                .filter((id) => !Object.hasOwn(perDefect, id));
              if (missingIds.length > 0) {
                problems.push(
                  `${dir} row condition ${condition} omits frozen defect ${missingIds.join(", ")} for scored result PR ${pr}`,
                );
              }
            }
          }
        }
      }
    } catch {
      // planProvenanceProblems reports the unreadable plan with its full error.
    }
  }
  if (!existsSync(path.join(dir, "calibration.json"))) {
    problems.push(`${dir} carries no calibration.json`);
  }
  return problems;
}

/** Canonical JSON text for evidence fingerprints. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest one run's exact canonical scored evidence, independent of layout. */
export function runEvidenceDigest(dir) {
  if (!existsSync(dir)) return null;
  if (nonRegularEvidenceProblems(dir).length > 0) return null;
  const files = readdirSync(dir)
    .filter(
      (name) =>
        name === "calibration.json" ||
        (name.startsWith("result-") && name.endsWith(".json")),
    )
    .sort();
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  const update = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  try {
    for (const file of files) {
      update(file);
      update(canonicalJson(readJson(path.join(dir, file))));
    }
  } catch {
    return null;
  }
  return hash.digest("hex");
}
